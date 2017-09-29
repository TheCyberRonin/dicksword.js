var acc = document.getElementsByClassName("collapse");
var i;

for (i = 0; i < acc.length; i++) {
    console.log(acc[i]);
    acc[i].onclick = function(){
        /* Toggle between adding and removing the "active" class,
        to highlight the button that controls the panel */
        this.classList.toggle("active");

        /* Toggle between hiding and showing the active panel */
        var list = this.nextElementSibling;
        if (list.style.display === "block") {
            list.style.display = "none";
        } else {
            list.style.display = "block";
        }
    }
}